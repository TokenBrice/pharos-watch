import type { DigestInputData } from "@shared/types/digest";
import { getCirculatingRaw } from "@shared/lib/supply";
import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import { DEWS_SIGNAL_LABELS, type DewsSignalKey } from "@shared/lib/dews-config";
import { THREAT_BAND_ORDER, isDewsAlertBand, isThreatBand } from "@shared/lib/classification";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import {
  safetyScoreHistoryIdentityFromV2Row,
  type SafetyScoreHistoryV2Row,
} from "../../lib/safety-score-history-v2";
import { loadIdentifiedActiveSafetyScoreSource } from "../../lib/identified-active-safety-score-source";
import { digestSafetyContextFromSource } from "../../lib/digest-safety-context";
import { SECONDS } from "../../lib/time-constants";
import {
  logCollectorParseFailure,
  markCollectorDegraded,
  type CollectorContext,
  type CanonicalSafetyGradeRow,
  type SafetyScoresResult,
} from "./collectors-shared";
import { unwrapStressSignalsEnvelope } from "@shared/lib/stress-signals-envelope";
import { loadPublishedStressSignalGeneration } from "../../lib/stress-signals-current-rows";
import { logWorkerEvent } from "../../lib/structured-log";

function parseStressSignalsMap(signalsJson: string): Record<string, { value: number; available: boolean }> {
  const parsed = JSON.parse(signalsJson) as unknown;
  const unwrapped = unwrapStressSignalsEnvelope(parsed);
  return (unwrapped?.signals ?? {}) as Record<string, { value: number; available: boolean }>;
}

function projectV9Pillar(
  pillar: {
    score: number | null;
    evidenceLevel: string;
    freshness: string;
    reasons: readonly { code: string; message: string }[];
  },
) {
  return {
    score: pillar.score,
    evidenceLevel: pillar.evidenceLevel,
    freshness: pillar.freshness,
    reasons: pillar.reasons.map((reason) => ({ code: reason.code, message: reason.message })),
  };
}

function projectV9Cap(
  cap: { kind: string; limit: number; reason: string; binding: boolean },
) {
  return {
    kind: cap.kind,
    limit: cap.limit,
    reason: cap.reason,
    binding: cap.binding,
  };
}

export async function collectSafetyScores(
  ctx: CollectorContext,
  mentionedSymbols: Set<string>,
  degradedReasons: string[],
): Promise<SafetyScoresResult> {
  try {
    const source = await loadIdentifiedActiveSafetyScoreSource(ctx.db);
    const safetyContext = digestSafetyContextFromSource(source);
    if (source.kind === "error") {
      markCollectorDegraded(degradedReasons, "safety-canonical-snapshot");
      console.error(
        `[daily-digest] Canonical Safety Score ${source.expectedModel.toUpperCase()} unavailable (${source.reason}): ${source.detail}`,
      );
      return {
        safetyScores: undefined,
        safetyGrades: undefined,
        safetyIdentity: undefined,
        safetyContext,
      };
    }

    const allGrades: CanonicalSafetyGradeRow[] = source.snapshot.cards
      .filter((card) => ctx.trackedStablecoinIds.has(card.id))
      .map((card) => ({
        id: card.id,
        symbol: ctx.stablecoinAssetById.get(card.id)?.symbol ?? card.id,
        grade: card.grade,
        score: card.score,
        pillars: {
          backing: projectV9Pillar(card.pillars.backing),
          exit: projectV9Pillar(card.pillars.exit),
          control: projectV9Pillar(card.pillars.control),
        },
        reasonCodes: [...card.reasonCodes],
        caps: card.caps.map(projectV9Cap),
        bindingCap: card.bindingCap ? projectV9Cap(card.bindingCap) : null,
      }));

    const mentionedCoinGrades = allGrades.filter((grade) => mentionedSymbols.has(grade.symbol));
    const reportCoins = [...mentionedCoinGrades];
    const reportIds = new Set(reportCoins.map((grade) => grade.id));
    const worstGraded = allGrades
      .filter((grade) => !reportIds.has(grade.id) && (ctx.mcapById.get(grade.id) ?? 0) > 10_000_000)
      .filter((grade) => grade.score !== null)
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
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

    const gradeDistribution: Record<string, number> = {};
    for (const grade of allGrades) {
      gradeDistribution[grade.grade] = (gradeDistribution[grade.grade] ?? 0) + 1;
    }
    return {
      safetyScores: {
        model: "v9",
        mentionedCoins: reportCoins.map((grade) => ({
          symbol: grade.symbol,
          grade: grade.grade,
          score: grade.score,
          pillars: grade.pillars,
          reasonCodes: grade.reasonCodes,
          caps: grade.caps,
          bindingCap: grade.bindingCap,
        })),
        gradeDistribution,
        provenance: { ...source.identity, publishedAt: source.publishedAtSec },
      },
      safetyGrades: allGrades,
      safetyIdentity: source.identity,
      safetyContext,
    };
  } catch (error) {
    markCollectorDegraded(degradedReasons, "safety-canonical-snapshot");
    console.error("[daily-digest] Failed to load canonical safety scores:", error);
    return {
      safetyScores: undefined,
      safetyGrades: undefined,
      safetyIdentity: undefined,
      safetyContext: {
        status: "unavailable",
        expectedModel: "v9",
        identity: null,
        publishedAt: null,
        reason: "source-load-failed",
      },
    };
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

    const todayRows = publishedDews.rows.filter((row) => ctx.trackedStablecoinIds.has(row.stablecoin_id));
    if (todayRows.length > 0) {
      const yesterdayDews = await ctx.db
        .prepare("SELECT stablecoin_id, score, band FROM stress_signal_history WHERE snapshot_date = ?")
        .bind(ctx.yesterdayTs)
        .all<{ stablecoin_id: string; score: number; band: string }>();

      const yesterdayRows = (yesterdayDews.results ?? []).filter((row) =>
        ctx.trackedStablecoinIds.has(row.stablecoin_id),
      );
      const yesterdayMap = new Map(yesterdayRows.map((row) => [row.stablecoin_id, row]));
      const initCounts = () => ({ calm: 0, watch: 0, alert: 0, warning: 0, danger: 0 });
      const bandCounts = initCounts();
      const yesterdayBandCounts = initCounts();

      for (const row of todayRows) {
        const key = row.band.toLowerCase() as keyof typeof bandCounts;
        if (key in bandCounts) bandCounts[key]++;
      }
      for (const row of yesterdayRows) {
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
              topDriver = key in DEWS_SIGNAL_LABELS ? DEWS_SIGNAL_LABELS[key as DewsSignalKey].toLowerCase() : key;
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
  safetyGrades: CanonicalSafetyGradeRow[] | undefined,
  safetyIdentity: SafetyScoreV9PublicationIdentity | undefined,
  degradedReasons?: string[],
): Promise<DigestInputData["gradeTransitions"]> {
  if (!safetyGrades || !safetyIdentity) return undefined;
  try {
    const cutoff48h = ctx.nowSec - 2 * 24 * 60 * 60;
    const policyClause = "AND policy_id = ? AND policy_digest = ?";
    const identityBinds = [
      safetyIdentity.model,
      safetyIdentity.schemaVersion,
      safetyIdentity.methodologyVersion,
      safetyIdentity.evaluationBuildDigest,
      safetyIdentity.policyId,
      safetyIdentity.policyDigest,
    ];
    const bumpRows = await ctx.db
      .prepare(
        `SELECT recorded_at,
                COUNT(*) as cnt,
                SUM(CASE WHEN score > prev_score THEN 1 ELSE 0 END) as upgrades,
                SUM(CASE WHEN score < prev_score THEN 1 ELSE 0 END) as downgrades
         FROM safety_score_history_v2
         WHERE recorded_at >= ?
           AND model = ?
           AND identity_schema_version = ?
           AND methodology_version = ?
           AND evaluation_build_digest = ?
           ${policyClause}
           AND transition_kind = 'organic-grade-change'
         GROUP BY recorded_at HAVING COUNT(*) > 15`,
      )
      .bind(
        cutoff48h,
        ...identityBinds,
      )
      .all<{ recorded_at: number; cnt: number; upgrades: number; downgrades: number }>();
    const bumpTimestamps = new Set(
      (bumpRows.results ?? [])
        .filter((row) => row.upgrades / row.cnt > 0.8 || row.downgrades / row.cnt > 0.8)
        .map((row) => row.recorded_at),
    );

    const transitionRows = await ctx.db
      .prepare(
        `SELECT history_id, stablecoin_id, recorded_at, model, identity_schema_version,
                methodology_version, policy_id, policy_digest, evaluation_build_digest,
                base_input_generation_id, model_publication_generation_id, transition_kind,
                grade, score, prev_grade, prev_score
         FROM safety_score_history_v2
         WHERE recorded_at >= ?
           AND model = ?
           AND identity_schema_version = ?
           AND methodology_version = ?
           AND evaluation_build_digest = ?
           ${policyClause}
           AND transition_kind = 'organic-grade-change'
         ORDER BY ABS(COALESCE(score, 0) - COALESCE(prev_score, 0)) DESC
         LIMIT 10`,
      )
      .bind(
        cutoff48h,
        ...identityBinds,
      )
      .all<SafetyScoreHistoryV2Row>();

    const candidates = (transitionRows.results ?? [])
      .filter((row) => !bumpTimestamps.has(row.recorded_at))
      .filter((row) => row.prev_grade !== null)
      .filter((row) =>
        safetyScorePublicationIdentitiesAreComparable(
          safetyScoreHistoryIdentityFromV2Row(row),
          safetyIdentity,
        ),
      )
      .filter((row) => {
        const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === row.stablecoin_id);
        return coin && getCirculatingRaw(coin) > 10_000_000;
      })
      .slice(0, 5);

    if (candidates.length > 0) {
      const gradeMap = new Map(safetyGrades.map((grade) => [grade.id, grade]));
      return candidates.map((row) => {
        const coin = ctx.trackedStablecoinAssets.find((candidate) => candidate.id === row.stablecoin_id)!;
        const currentGrade = gradeMap.get(row.stablecoin_id);
        const rowIdentity = safetyScoreHistoryIdentityFromV2Row(row);
        if (rowIdentity.model !== "v9") {
          throw new Error("Canonical V9 transition query returned a non-V9 history row");
        }
        const base = {
          historyId: row.history_id,
          recordedAt: row.recorded_at,
          symbol: coin.symbol,
          fromGrade: row.prev_grade!,
          toGrade: row.grade,
          fromScore: row.prev_score,
          toScore: row.score,
          mcapUsd: getCirculatingRaw(coin),
        };
        return {
          ...base,
          model: "v9" as const,
          safetyScoreIdentity: rowIdentity,
          currentPillars: currentGrade?.pillars ?? {
            backing: { score: null, evidenceLevel: "unknown", freshness: "unknown", reasons: [] },
            exit: { score: null, evidenceLevel: "unknown", freshness: "unknown", reasons: [] },
            control: { score: null, evidenceLevel: "unknown", freshness: "unknown", reasons: [] },
          },
          reasonCodes: currentGrade?.reasonCodes ?? [],
          caps: currentGrade?.caps ?? [],
          bindingCap: currentGrade?.bindingCap ?? null,
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
        // Rows older than 24h describe a market that may no longer exist;
        // stale anomaly prints repeated across editions were a corpus defect.
        `SELECT stablecoin_id, symbol, current_apy, apy_7d, apy_30d, warning_signals
         FROM yield_data
         WHERE is_best = 1
           AND (publication_generation_id IS NULL OR publication_state = 'published')
           AND warning_signals IS NOT NULL
           AND warning_signals != '[]'
           AND updated_at > ?
         ORDER BY current_apy DESC`,
      )
      .bind(ctx.nowSec - SECONDS.ONE_DAY)
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
