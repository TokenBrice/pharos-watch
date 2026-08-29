import { logWorkerEventArgs } from "../../lib/structured-log";
import type { DigestInputData } from "@shared/types/digest";
import { round1 } from "@shared/lib/math";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import { SECONDS } from "../../lib/time-constants";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "../../lib/digest-sql-filters";
import {
  collectorDegraded,
  collectorOk,
  collectorResult,
  logCollectorParseFailure,
  type CollectorContext,
  type CollectorResult,
} from "./collectors-shared";

export async function collectTotalMcapAth(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestInputData["totalMcapAth"]>> {
  try {
    const row = await ctx.db
      .prepare(
        `SELECT CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) as ath_value, generated_at as ath_date
         FROM daily_digest
         WHERE (${NON_WEEKLY_DIGEST_SQL_FILTER})
           AND json_extract(input_data, '$.aggregateUniverse') = 'core-stablecoins-v1'
           AND json_extract(input_data, '$.totalMcapUsd') IS NOT NULL
         ORDER BY CAST(json_extract(input_data, '$.totalMcapUsd') AS REAL) DESC
         LIMIT 1`,
      )
      .first<{ ath_value: number | null; ath_date: number | null }>();
    if (!row || row.ath_value == null || row.ath_date == null || row.ath_value <= 0) return collectorOk(undefined);
    const dayTs = bucketUnixSecondsToUtcDay(row.ath_date);
    return collectorOk({
      value: row.ath_value,
      date: dayTs,
      daysAgo: Math.max(0, Math.round((ctx.todayTs - dayTs) / SECONDS.ONE_DAY)),
    });
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to collect total mcap ATH:", error);
    return collectorDegraded(undefined, "total-mcap-ath-query");
  }
}

export async function collectPsiContributors(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestInputData["psiContributors"]>> {
  const degradedReasons: string[] = [];
  try {
    const latestSample = await ctx.db
      .prepare("SELECT input_snapshot, stored_at FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ input_snapshot: string; stored_at: number }>();
    if (!latestSample || typeof latestSample.input_snapshot !== "string") return collectorOk(undefined);
    // A stale sample's per-coin attribution presented as current is worse
    // than no attribution at all; drop it and record the degradation.
    if (ctx.nowSec - latestSample.stored_at > 2 * SECONDS.ONE_HOUR) {
      degradedReasons.push("psi-contributors-stale");
      return collectorResult(undefined, degradedReasons);
    }

    const snapshot = JSON.parse(latestSample.input_snapshot) as {
      contributors?: { id: string; symbol: string; bps: number; mcapUsd: number; ageDays: number; factor: number }[];
    };
    if (!snapshot.contributors || snapshot.contributors.length === 0) return collectorOk(undefined);

    return collectorResult(snapshot.contributors
      .filter(
        (contributor) =>
          typeof contributor.bps === "number" &&
          typeof contributor.mcapUsd === "number" &&
          typeof contributor.factor === "number" &&
          contributor.bps >= 0 &&
          contributor.bps <= 10000 &&
          contributor.factor >= 0 &&
          contributor.mcapUsd > 0,
      )
      .map((contributor) => ({
        symbol: contributor.symbol,
        bps: contributor.bps,
        mcapUsd: contributor.mcapUsd,
        marketImpact: round1(((Math.abs(contributor.bps) * contributor.mcapUsd) / 1e9) * contributor.factor),
      }))
      .sort((a, b) => b.marketImpact - a.marketImpact)
      .slice(0, 3), degradedReasons);
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to collect PSI contributors:", error);
    degradedReasons.push("psi-contributors-query");
    return collectorResult(undefined, degradedReasons);
  }
}

export async function collectHistoricalContext(
  ctx: CollectorContext,
  displayScore: number | null,
  displayBand: string | null,
  biggestSupplyChange: DigestInputData["biggestSupplyChange"],
): Promise<CollectorResult<DigestInputData["historicalContext"]>> {
  const degradedReasons: string[] = [];
  try {
    const histDepth = await ctx.db.prepare("SELECT COUNT(*) as cnt FROM stability_index").first<{ cnt: number }>();

    const oldestDigest = await ctx.db
      .prepare(
        `SELECT MIN(generated_at) as oldest FROM daily_digest
         WHERE ${NON_WEEKLY_DIGEST_SQL_FILTER}`,
      )
      .first<{ oldest: number | null }>();
    const digestTrackingDays = oldestDigest?.oldest
      ? Math.round((ctx.todayTs - oldestDigest.oldest) / SECONDS.ONE_DAY)
      : 0;

    if (displayScore != null && displayBand && (histDepth?.cnt ?? 0) > 30) {
      const digestPrecedent = await ctx.db
        .prepare(
          `SELECT generated_at,
                  json_extract(input_data, '$.stabilityIndex.score') as psi_score,
                  json_extract(input_data, '$.stabilityIndex.band') as psi_band
           FROM daily_digest
           WHERE json_extract(input_data, '$.stabilityIndex.score') <= ?
             AND generated_at < ?
             AND (${NON_WEEKLY_DIGEST_SQL_FILTER})
           ORDER BY generated_at DESC LIMIT 1`,
        )
        .bind(displayScore, ctx.todayTs)
        .first<{ generated_at: number; psi_score: number; psi_band: string }>();

      let psiPrecedent: {
        lastSeenDate: number;
        lastSeenDaysAgo: number;
        lastSeenScore: number;
        lastSeenBand: string;
      } | null = null;

      if (digestPrecedent) {
        const dayTs = bucketUnixSecondsToUtcDay(digestPrecedent.generated_at);
        psiPrecedent = {
          lastSeenDate: dayTs,
          lastSeenDaysAgo: Math.round((ctx.todayTs - dayTs) / SECONDS.ONE_DAY),
          lastSeenScore: digestPrecedent.psi_score,
          lastSeenBand: digestPrecedent.psi_band,
        };
      }

      const bandHistory = await ctx.db
        .prepare(
          "SELECT computed_at, band FROM stability_index WHERE computed_at <= ? ORDER BY computed_at DESC LIMIT 90",
        )
        .bind(ctx.todayTs)
        .all<{ computed_at: number; band: string }>();

      let psiBandStreak = 0;
      for (const row of bandHistory.results ?? []) {
        if (row.band === displayBand) psiBandStreak++;
        else break;
      }
      if (psiBandStreak === 0) psiBandStreak = 1;

      let supplyMoverContext: NonNullable<DigestInputData["historicalContext"]>["supplyMoverContext"] = null;
      if (biggestSupplyChange) {
        const athRow = await ctx.db
          .prepare(
            "SELECT circulating_usd AS ath_mcap, snapshot_date FROM supply_history WHERE stablecoin_id = ? ORDER BY circulating_usd DESC LIMIT 1",
          )
          .bind(biggestSupplyChange.id)
          .first<{ ath_mcap: number | null; snapshot_date: number }>();
        const athDate = athRow?.snapshot_date ?? 0;

        const largestChangeRow = await ctx.db
          .prepare(
            `SELECT s1.snapshot_date, ABS(s1.circulating_usd - s2.circulating_usd) as abs_change
             FROM supply_history s1
             JOIN supply_history s2
               ON s1.stablecoin_id = s2.stablecoin_id
               AND s2.snapshot_date = s1.snapshot_date - ?
             WHERE s1.stablecoin_id = ?
             ORDER BY abs_change DESC LIMIT 1`,
          )
          .bind(7 * SECONDS.ONE_DAY, biggestSupplyChange.id)
          .first<{ snapshot_date: number; abs_change: number }>();

        if (athRow?.ath_mcap && largestChangeRow) {
          supplyMoverContext = {
            allTimeHighMcap: athRow.ath_mcap,
            allTimeHighDate: athDate,
            largestWeeklyChange: largestChangeRow.abs_change,
            largestWeeklyChangeDate: largestChangeRow.snapshot_date,
            largestWeeklyChangeDaysAgo: Math.round((ctx.todayTs - largestChangeRow.snapshot_date) / SECONDS.ONE_DAY),
          };
        }
      }

      return collectorResult({ psiPrecedent, psiBandStreak, digestTrackingDays, supplyMoverContext }, degradedReasons);
    }
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to collect historical context:", error);
    degradedReasons.push("historical-context-query");
    return collectorResult(undefined, degradedReasons);
  }
  return collectorResult(undefined, degradedReasons);
}

export async function collectCrossDayTrends(
  ctx: CollectorContext,
): Promise<CollectorResult<DigestInputData["crossDayTrends"]>> {
  const degradedReasons: string[] = [];
  try {
    const rows = await ctx.db
      .prepare(
        `SELECT generated_at, input_data FROM daily_digest
         WHERE generated_at >= ?
           AND (${NON_WEEKLY_DIGEST_SQL_FILTER})
         ORDER BY generated_at DESC
         LIMIT 7`,
      )
      .bind(ctx.nowSec - 7 * SECONDS.ONE_DAY)
      .all<{ generated_at: number; input_data: string }>();

    const entries = rows.results ?? [];
    if (entries.length < 3) return collectorOk(undefined);

    const psiTrajectory: { date: string; score: number; band: string }[] = [];
    const mcapTrajectory: { date: string; mcapUsd: number }[] = [];
    const legacyMcapTrajectory: { date: string; mcapUsd: number }[] = [];
    const gaugeTrajectory: { date: string; gaugeScore: number }[] = [];

    for (const row of entries) {
      try {
        const data = JSON.parse(row.input_data) as DigestInputData;
        const date = new Date(row.generated_at * 1000).toISOString().slice(0, 10);

        if (data.stabilityIndex) {
          psiTrajectory.push({ date, score: data.stabilityIndex.score, band: data.stabilityIndex.band });
        }
        if (data.aggregateUniverse === "core-stablecoins-v1") {
          mcapTrajectory.push({ date, mcapUsd: data.totalMcapUsd });
        }
        legacyMcapTrajectory.push({ date, mcapUsd: data.totalMcapUsd });
        if (data.mintBurnFlows) {
          gaugeTrajectory.push({ date, gaugeScore: data.mintBurnFlows.gaugeScore });
        }
      } catch (error) {
        degradedReasons.push("cross-day-trend-input-json");
        logCollectorParseFailure("cross-day-trends", "input_data", error, { generatedAt: row.generated_at });
      }
    }

    psiTrajectory.reverse();
    if (mcapTrajectory.length === 0) {
      mcapTrajectory.push(...legacyMcapTrajectory);
    }
    mcapTrajectory.reverse();
    gaugeTrajectory.reverse();

    return collectorResult({
      psiTrajectory,
      mcapTrajectory,
      gaugeTrajectory: gaugeTrajectory.length >= 3 ? gaugeTrajectory : null,
    }, degradedReasons);
  } catch (error) {
    logWorkerEventArgs("handler", "error", "[daily-digest] Failed to collect cross-day trends:", error);
    degradedReasons.push("cross-day-trends-query");
    return collectorResult(undefined, degradedReasons);
  }
}
