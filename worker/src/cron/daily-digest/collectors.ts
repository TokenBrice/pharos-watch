/**
 * Data collection functions for the daily digest pipeline.
 *
 * Each collector gathers one category of enrichment data and returns
 * the typed result or `undefined` on failure. The orchestrator calls
 * them sequentially and assembles the results into DigestInputData.
 */

import type { DigestInputData, StablecoinData } from "@shared/types";
import { getCirculatingRaw } from "@shared/lib/supply";
import { scoreToGrade } from "@shared/lib/report-cards";
import { buildInClause } from "../../lib/db";
import { SECONDS } from "../../lib/time-constants";
import { computeSafetyScoresSnapshot, type SafetyGradeRow } from "../../lib/safety-scores";
import { computeFlowIntensity, computeGaugeScore, getGaugeBand, detectFlightToQuality } from "../../lib/mint-burn-scoring";
import { SAFE_HAVEN_IDS } from "../../lib/mint-burn-contracts";

// ---------------------------------------------------------------------------
// Shared context passed from the orchestrator to every collector
// ---------------------------------------------------------------------------

export interface CollectorContext {
  db: D1Database;
  trackedStablecoinAssets: StablecoinData[];
  mcapById: Map<string, number>;
  nowSec: number;
  todayTs: number;
  yesterdayTs: number;
}

// ---------------------------------------------------------------------------
// 1. Active depegs
// ---------------------------------------------------------------------------

export async function collectActiveDepegs(
  ctx: CollectorContext,
): Promise<{ activeDepegCount: number; topDepegs: DigestInputData["topDepegs"] }> {
  try {
    const activeDepegs = await ctx.db
      .prepare("SELECT stablecoin_id, symbol, peak_deviation_bps FROM depeg_events WHERE ended_at IS NULL")
      .all<{ stablecoin_id: string; symbol: string; peak_deviation_bps: number }>();
    const rows = activeDepegs.results ?? [];

    const withImpact = rows.map((r) => {
      const mcapUsd = ctx.mcapById.get(r.stablecoin_id) ?? 0;
      return { symbol: r.symbol, bps: r.peak_deviation_bps, mcapUsd, impact: r.peak_deviation_bps * mcapUsd };
    });
    withImpact.sort((a, b) => b.impact - a.impact);
    const topDepegs = withImpact.slice(0, 3).map(({ symbol, bps, mcapUsd }) => ({ symbol, bps, mcapUsd }));

    return { activeDepegCount: rows.length, topDepegs };
  } catch (e) {
    console.error("[daily-digest] Failed to query active depegs:", e);
    return { activeDepegCount: 0, topDepegs: [] };
  }
}

// ---------------------------------------------------------------------------
// 2. Blacklist activity (last 24h)
// ---------------------------------------------------------------------------

export async function collectBlacklistActivity(
  ctx: CollectorContext,
): Promise<DigestInputData["blacklistActivity"]> {
  try {
    const blRows = await ctx.db
      .prepare(
        "SELECT stablecoin AS symbol, chain_name, event_type, amount FROM blacklist_events WHERE timestamp >= ? AND timestamp < ? ORDER BY amount DESC",
      )
      .bind(ctx.todayTs - SECONDS.ONE_DAY, ctx.todayTs)
      .all<{ symbol: string; chain_name: string; event_type: string; amount: number | null }>();
    const blEvents = blRows.results ?? [];
    if (blEvents.length > 0) {
      const eventCount = blEvents.length;
      const totalAmountUsd = blEvents.reduce((s, e) => s + (e.amount ?? 0), 0);
      const hasLargeEvent = blEvents.some((e) => (e.amount ?? 0) > 10_000_000);
      if (eventCount >= 2 || hasLargeEvent) {
        return {
          eventCount,
          totalAmountUsd,
          topEvents: blEvents
            .filter((e) => e.event_type === "blacklist" || e.event_type === "destroy")
            .slice(0, 5)
            .map((e) => ({
              symbol: e.symbol,
              chain: e.chain_name,
              type: e.event_type as "blacklist" | "destroy",
              amountUsd: e.amount ?? 0,
            })),
        };
      }
    }
  } catch (e) {
    console.error("[daily-digest] Failed to query blacklist events:", e);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 3. Supply velocity (1d vs 7d for top 10 coins by mcap)
// ---------------------------------------------------------------------------

export async function collectSupplyVelocity(
  ctx: CollectorContext,
): Promise<DigestInputData["supplyVelocity"]> {
  try {
    const top10 = ctx.trackedStablecoinAssets
      .map((coin) => ({ id: coin.id, symbol: coin.symbol, mcap: getCirculatingRaw(coin) }))
      .sort((a, b) => b.mcap - a.mcap)
      .slice(0, 10);

    if (top10.length > 0) {
      const yesterday = ctx.todayTs - SECONDS.ONE_DAY;
      const weekAgo = ctx.todayTs - 7 * SECONDS.ONE_DAY;
      const top10IdInClause = buildInClause(top10.map((coin) => coin.id));
      const supplyRows = await ctx.db
        .prepare(
          `SELECT stablecoin_id, snapshot_date, circulating_usd FROM supply_history WHERE stablecoin_id IN (${top10IdInClause.sql}) AND snapshot_date IN (?, ?, ?)`,
        )
        .bind(...top10IdInClause.binds, ctx.todayTs, yesterday, weekAgo)
        .all<{ stablecoin_id: string; snapshot_date: number; circulating_usd: number }>();

      const snapMap = new Map<string, Map<number, number>>();
      for (const row of supplyRows.results ?? []) {
        let byDate = snapMap.get(row.stablecoin_id);
        if (!byDate) { byDate = new Map(); snapMap.set(row.stablecoin_id, byDate); }
        byDate.set(row.snapshot_date, row.circulating_usd);
      }

      const velocitySignals: NonNullable<DigestInputData["supplyVelocity"]> = [];
      for (const coin of top10) {
        const byDate = snapMap.get(coin.id);
        if (!byDate) continue;
        const todayVal = byDate.get(ctx.todayTs);
        const yesterdayVal = byDate.get(yesterday);
        const weekAgoVal = byDate.get(weekAgo);
        if (todayVal == null || yesterdayVal == null || weekAgoVal == null) continue;

        const change1d = todayVal - yesterdayVal;
        const change7d = todayVal - weekAgoVal;
        const dailyAvg7d = change7d / 7;

        const directionReversed = (change1d > 0 && change7d < 0) || (change1d < 0 && change7d > 0);
        const velocityRatio = dailyAvg7d !== 0 ? Math.abs(change1d / dailyAvg7d) : 0;

        if (directionReversed || velocityRatio > 2.5) {
          let signal: string;
          if (directionReversed) signal = "reversed";
          else if (velocityRatio > 2.5 && Math.abs(change1d) > Math.abs(dailyAvg7d)) signal = "accelerating";
          else signal = "decelerating";

          velocitySignals.push({ coin: coin.symbol, change1d, change7d, signal });
        }
      }

      if (velocitySignals.length > 0) {
        return velocitySignals;
      }
    }
  } catch (e) {
    console.error("[daily-digest] Failed to compute supply velocity:", e);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 4. Safety scores
// ---------------------------------------------------------------------------

export interface SafetyScoresResult {
  safetyScores: DigestInputData["safetyScores"];
  safetyGrades: SafetyGradeRow[] | undefined;
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

    // Distribution stats
    const scores = allGrades.map((g) => g.score).sort((a, b) => a - b);
    const medianScore = scores.length > 0 ? scores[Math.floor(scores.length / 2)] : 0;
    const medianGrade = scoreToGrade(medianScore);
    const aboveBCount = allGrades.filter((g) => g.score >= 75).length;
    const fCount = allGrades.filter((g) => g.grade === "F").length;

    // Per-coin grades for mentioned coins + up to 2 "notable tension" coins
    const mentionedCoinGrades = allGrades.filter((g) => mentionedSymbols.has(g.symbol));
    const tensionCoins = allGrades
      .filter((g) => !mentionedSymbols.has(g.symbol) && g.pegScore !== null && g.pegScore > 90 && g.score < 50)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    const reportCoins = [...mentionedCoinGrades, ...tensionCoins];

    return {
      safetyScores: {
        mentionedCoins: reportCoins.map((g) => ({
          symbol: g.symbol, grade: g.grade, score: g.score,
          peg: g.pegScore, liq: g.liqScore,
        })),
        medianGrade,
        aboveBCount,
        fCount,
      },
      safetyGrades: allGrades,
    };
  } catch (e) {
    console.error("[daily-digest] Failed to compute safety scores:", e);
    return { safetyScores: undefined, safetyGrades: undefined };
  }
}

// ---------------------------------------------------------------------------
// 5. Recently resolved depegs (last 48h)
// ---------------------------------------------------------------------------

export async function collectResolvedDepegs(
  ctx: CollectorContext,
): Promise<DigestInputData["resolvedDepegs"]> {
  try {
    const cutoff48h = ctx.nowSec - SECONDS.TWO_DAYS;
    const resolvedRows = await ctx.db
      .prepare(
        `SELECT symbol, peak_deviation_bps, started_at, ended_at, stablecoin_id
         FROM depeg_events
         WHERE ended_at IS NOT NULL AND ended_at >= ?
         ORDER BY peak_deviation_bps DESC
         LIMIT 5`,
      )
      .bind(cutoff48h)
      .all<{ symbol: string; peak_deviation_bps: number; started_at: number; ended_at: number; stablecoin_id: string }>();

    const candidates = (resolvedRows.results ?? [])
      .map((r) => ({
        symbol: r.symbol,
        peakBps: Math.abs(r.peak_deviation_bps),
        durationHours: Math.round((r.ended_at - r.started_at) / SECONDS.ONE_HOUR),
        mcapUsd: ctx.mcapById.get(r.stablecoin_id) ?? 0,
      }))
      .filter((r) => r.peakBps > 200 && r.mcapUsd > 50_000_000)
      .slice(0, 3);

    if (candidates.length > 0) {
      return candidates;
    }
  } catch (e) {
    console.error("[daily-digest] Failed to query resolved depegs:", e);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 6. Mint-burn flows (24h + 30d baseline)
// ---------------------------------------------------------------------------

export async function collectMintBurnFlows(
  ctx: CollectorContext,
): Promise<DigestInputData["mintBurnFlows"]> {
  try {
    const cutoff24h = ctx.nowSec - SECONDS.ONE_DAY;
    const cutoff30d = ctx.nowSec - 30 * SECONDS.ONE_DAY;

    // 24h aggregate per coin (across all chains)
    const flow24hRows = await ctx.db
      .prepare(
        `SELECT stablecoin_id,
                SUM(mint_volume_usd) as mint_24h,
                SUM(burn_volume_usd) as burn_24h,
                SUM(net_flow_usd) as net_24h
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind(cutoff24h)
      .all<{ stablecoin_id: string; mint_24h: number; burn_24h: number; net_24h: number }>();

    // 30d baseline per coin
    const flow30dRows = await ctx.db
      .prepare(
        `SELECT stablecoin_id,
                SUM(net_flow_usd) / 30.0 as avg_daily_net,
                SUM(mint_volume_usd + burn_volume_usd) / 30.0 as avg_daily_abs,
                COUNT(DISTINCT CAST(hour_ts / 86400 AS INTEGER)) as data_days
         FROM mint_burn_hourly
         WHERE hour_ts >= ?
         GROUP BY stablecoin_id`,
      )
      .bind(cutoff30d)
      .all<{ stablecoin_id: string; avg_daily_net: number; avg_daily_abs: number; data_days: number }>();

    const flow24h = new Map((flow24hRows.results ?? []).map((r) => [r.stablecoin_id, r]));
    const flow30d = new Map((flow30dRows.results ?? []).map((r) => [r.stablecoin_id, r]));

    // Compute FIS per coin
    const coinIntensities: { id: string; symbol: string; intensity: number | null; net24h: number; mcap: number }[] = [];
    for (const [id, f24] of flow24h) {
      const f30 = flow30d.get(id);
      if (!f30) continue;
      const coin = ctx.trackedStablecoinAssets.find((c) => c.id === id);
      if (!coin) continue;
      const intensity = computeFlowIntensity({
        currentDailyNet: f24.net_24h,
        baselineDailyNet: f30.avg_daily_net,
        baselineDailyAbs: f30.avg_daily_abs,
        dataAgeDays: f30.data_days,
        currentDailyAbs: f24.mint_24h + f24.burn_24h,
      });
      coinIntensities.push({ id, symbol: coin.symbol, intensity, net24h: f24.net_24h, mcap: getCirculatingRaw(coin) });
    }

    const gaugeScore = computeGaugeScore(coinIntensities.map((c) => ({ intensity: c.intensity, mcap: c.mcap })));
    if (gaugeScore !== null) {
      // FTQ: sum net flows for safe vs risky
      let safeNet24h = 0;
      let riskyNet24h = 0;
      for (const c of coinIntensities) {
        if (SAFE_HAVEN_IDS.has(c.id)) safeNet24h += c.net24h;
        else riskyNet24h += c.net24h;
      }
      const ftq = detectFlightToQuality({ safeNet24h, riskyNet24h });

      // Top pressure: coins with |intensity| > 20, sorted by |intensity|
      const topPressure = coinIntensities
        .filter((c) => c.intensity !== null && Math.abs(c.intensity) > 20)
        .sort((a, b) => Math.abs(b.intensity!) - Math.abs(a.intensity!))
        .slice(0, 3)
        .map((c) => ({ symbol: c.symbol, intensity: c.intensity!, net24hUsd: c.net24h }));

      return {
        gaugeScore,
        gaugeBand: getGaugeBand(gaugeScore).label,
        flightToQuality: { active: ftq.active, safeNetUsd: safeNet24h, riskyNetUsd: riskyNet24h },
        topPressure,
      };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect mint-burn flows:", e);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 7. DEWS stress signals
// ---------------------------------------------------------------------------

export async function collectDewsStress(
  ctx: CollectorContext,
): Promise<DigestInputData["dewsStress"]> {
  try {
    // Latest DEWS per coin (most recent sample)
    const latestDews = await ctx.db
      .prepare(
        `SELECT s.stablecoin_id, s.score, s.band, s.signals_json
         FROM stress_signals s
         INNER JOIN (
           SELECT stablecoin_id, MAX(computed_at) as max_at
           FROM stress_signals GROUP BY stablecoin_id
         ) latest ON s.stablecoin_id = latest.stablecoin_id AND s.computed_at = latest.max_at`,
      )
      .all<{ stablecoin_id: string; score: number; band: string; signals_json: string }>();

    const todayRows = latestDews.results ?? [];
    if (todayRows.length > 0) {
      // Yesterday's snapshot for band-change detection
      const yesterdayDews = await ctx.db
        .prepare("SELECT stablecoin_id, score, band FROM stress_signal_history WHERE snapshot_date = ?")
        .bind(ctx.yesterdayTs)
        .all<{ stablecoin_id: string; score: number; band: string }>();

      const yesterdayMap = new Map((yesterdayDews.results ?? []).map((r) => [r.stablecoin_id, r]));

      // Band counts
      const initCounts = () => ({ calm: 0, watch: 0, alert: 0, warning: 0, danger: 0 });
      const bandCounts = initCounts();
      const yesterdayBandCounts = initCounts();

      for (const r of todayRows) {
        const key = r.band.toLowerCase() as keyof typeof bandCounts;
        if (key in bandCounts) bandCounts[key]++;
      }
      for (const r of yesterdayDews.results ?? []) {
        const key = r.band.toLowerCase() as keyof typeof yesterdayBandCounts;
        if (key in yesterdayBandCounts) yesterdayBandCounts[key]++;
      }

      // Band changes crossing WATCH/ALERT boundary
      const SIGNAL_LABELS: Record<string, string> = {
        supply: "supply velocity", pool: "pool balance drift", liq: "liquidity erosion",
        price: "price confidence", diverg: "cross-source divergence", black: "blacklist activity",
        flow: "mint/burn flow", yield: "yield anomaly",
      };
      const ALERT_BANDS = new Set(["ALERT", "WARNING", "DANGER"]);
      const bandChanges: NonNullable<DigestInputData["dewsStress"]>["bandChanges"] = [];

      for (const today of todayRows) {
        const yesterday = yesterdayMap.get(today.stablecoin_id);
        if (!yesterday || yesterday.band === today.band) continue;
        // Only include if crossing the WATCH/ALERT boundary
        const wasElevated = ALERT_BANDS.has(yesterday.band);
        const isElevated = ALERT_BANDS.has(today.band);
        if (wasElevated === isElevated) continue;

        // Extract top driver from signals_json
        let topDriver = "unknown";
        try {
          const signals = JSON.parse(today.signals_json) as Record<string, { value: number; available: boolean }>;
          let maxVal = -1;
          for (const [key, sig] of Object.entries(signals)) {
            if (sig.available && sig.value > maxVal) { maxVal = sig.value; topDriver = SIGNAL_LABELS[key] ?? key; }
          }
        } catch { /* use "unknown" */ }

        const coin = ctx.trackedStablecoinAssets.find((c) => c.id === today.stablecoin_id);
        if (!coin) continue;
        bandChanges.push({ symbol: coin.symbol, from: yesterday.band, to: today.band, score: today.score, topDriver });
      }

      // Elevated coins: ALERT+ with mcap > $10M
      const elevatedCoins = todayRows
        .filter((r) => ALERT_BANDS.has(r.band))
        .map((r) => {
          const coin = ctx.trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id);
          if (!coin) return null;

          let topSignals: { name: string; value: number }[] = [];
          try {
            const signals = JSON.parse(r.signals_json) as Record<string, { value: number; available: boolean }>;
            topSignals = Object.entries(signals)
              .filter(([, sig]) => sig.available && sig.value > 0)
              .sort(([, a], [, b]) => b.value - a.value)
              .slice(0, 3)
              .map(([key, sig]) => ({ name: SIGNAL_LABELS[key] ?? key, value: Math.round(sig.value) }));
          } catch { /* expected: malformed signals_json — render without top signals */ }

          return {
            symbol: coin.symbol, band: r.band, score: r.score,
            mcapUsd: getCirculatingRaw(coin), topSignals,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null && r.mcapUsd > 10_000_000)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      return { bandCounts, yesterdayBandCounts, bandChanges: bandChanges.slice(0, 5), elevatedCoins };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect DEWS stress signals:", e);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 8. PSI contributors (top coins driving the stability index score)
// ---------------------------------------------------------------------------

export async function collectPsiContributors(
  ctx: CollectorContext,
): Promise<DigestInputData["psiContributors"]> {
  try {
    const latestSample = await ctx.db
      .prepare("SELECT input_snapshot FROM stability_index_samples ORDER BY stored_at DESC LIMIT 1")
      .first<{ input_snapshot: string }>();
    if (!latestSample) return undefined;

    const snapshot = JSON.parse(latestSample.input_snapshot) as {
      contributors?: { id: string; symbol: string; bps: number; mcapUsd: number; ageDays: number; factor: number }[];
    };
    if (!snapshot.contributors || snapshot.contributors.length === 0) return undefined;

    return snapshot.contributors
      .filter((c) => typeof c.bps === "number" && typeof c.mcapUsd === "number" && typeof c.factor === "number")
      .map((c) => ({
        symbol: c.symbol,
        bps: c.bps,
        mcapUsd: c.mcapUsd,
        marketImpact: Math.round(Math.abs(c.bps) * c.mcapUsd / 1e9 * c.factor * 10) / 10,
      }))
      .sort((a, b) => b.marketImpact - a.marketImpact)
      .slice(0, 3);
  } catch (e) {
    console.error("[daily-digest] Failed to collect PSI contributors:", e);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 9. Historical context (PSI precedent, band streak, supply mover)
// ---------------------------------------------------------------------------

export async function collectHistoricalContext(
  ctx: CollectorContext,
  displayScore: number | null,
  displayBand: string | null,
  biggestSupplyChange: DigestInputData["biggestSupplyChange"],
): Promise<DigestInputData["historicalContext"]> {
  try {
    // Check we have enough history (>30 days)
    const histDepth = await ctx.db
      .prepare("SELECT COUNT(*) as cnt FROM stability_index")
      .first<{ cnt: number }>();

    if (displayScore != null && displayBand && (histDepth?.cnt ?? 0) > 30) {
      // PSI precedent: last time the digest reported a score at or below current.
      // Query previous daily digests (not stability_index daily snapshots) so we
      // compare displayed rolling-24h avgs against displayed rolling-24h avgs —
      // the stability_index table uses midnight-to-midnight windows that diverge
      // from the displayed score during trending periods.
      const DAILY_DIGEST_FILTER = "digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly'";
      const digestPrecedent = await ctx.db
        .prepare(
          `SELECT generated_at,
                  json_extract(input_data, '$.stabilityIndex.score') as psi_score,
                  json_extract(input_data, '$.stabilityIndex.band') as psi_band
           FROM daily_digest
           WHERE json_extract(input_data, '$.stabilityIndex.score') <= ?
             AND generated_at < ?
             AND (${DAILY_DIGEST_FILTER})
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
        const dayTs = digestPrecedent.generated_at - (digestPrecedent.generated_at % SECONDS.ONE_DAY);
        psiPrecedent = {
          lastSeenDate: dayTs,
          lastSeenDaysAgo: Math.round((ctx.todayTs - dayTs) / SECONDS.ONE_DAY),
          lastSeenScore: digestPrecedent.psi_score,
          lastSeenBand: digestPrecedent.psi_band,
        };
      }

      // PSI band streak: count consecutive days in current band
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

      // Supply mover context
      let supplyMoverContext: NonNullable<DigestInputData["historicalContext"]>["supplyMoverContext"] = null;
      if (biggestSupplyChange) {
        const athRow = await ctx.db
          .prepare("SELECT MAX(circulating_usd) as ath_mcap FROM supply_history WHERE stablecoin_id = ?")
          .bind(biggestSupplyChange.id)
          .first<{ ath_mcap: number | null }>();

        // ATH date (separate query since D1 doesn't support argmax)
        let athDate = 0;
        if (athRow?.ath_mcap) {
          const athDateRow = await ctx.db
            .prepare(
              "SELECT snapshot_date FROM supply_history WHERE stablecoin_id = ? AND circulating_usd = ? ORDER BY snapshot_date DESC LIMIT 1",
            )
            .bind(biggestSupplyChange.id, athRow.ath_mcap)
            .first<{ snapshot_date: number }>();
          athDate = athDateRow?.snapshot_date ?? 0;
        }

        // Largest historical 7d change
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
            largestWeeklyChangeDaysAgo: Math.round(
              (ctx.todayTs - largestChangeRow.snapshot_date) / SECONDS.ONE_DAY,
            ),
          };
        }
      }

      return { psiPrecedent, psiBandStreak, supplyMoverContext };
    }
  } catch (e) {
    console.error("[daily-digest] Failed to collect historical context:", e);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 10. Grade transitions (last 48h)
// ---------------------------------------------------------------------------

export async function collectGradeTransitions(
  ctx: CollectorContext,
  safetyGrades: SafetyGradeRow[] | undefined,
): Promise<DigestInputData["gradeTransitions"]> {
  try {
    const cutoff48h = ctx.nowSec - SECONDS.TWO_DAYS;

    // Check for methodology bumps (>10 simultaneous transitions = version change)
    const bumpRows = await ctx.db
      .prepare(
        `SELECT recorded_at FROM safety_grade_history
         WHERE recorded_at >= ? AND prev_grade IS NOT NULL
         GROUP BY recorded_at HAVING COUNT(*) > 10`,
      )
      .bind(cutoff48h)
      .all<{ recorded_at: number }>();
    const bumpTimestamps = new Set((bumpRows.results ?? []).map((r) => r.recorded_at));

    // Get transitions sorted by largest score change
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
      .filter((r) => !bumpTimestamps.has(r.recorded_at))
      .filter((r) => {
        const coin = ctx.trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id);
        return coin && getCirculatingRaw(coin) > 10_000_000;
      })
      .slice(0, 5);

    if (candidates.length > 0 && safetyGrades) {
      const gradeMap = new Map(safetyGrades.map((g) => [g.id, g]));

      return candidates.map((r) => {
        const coin = ctx.trackedStablecoinAssets.find((c) => c.id === r.stablecoin_id)!;
        const currentGrade = gradeMap.get(r.stablecoin_id);
        return {
          symbol: coin.symbol,
          fromGrade: r.prev_grade,
          toGrade: r.grade,
          fromScore: r.prev_score,
          toScore: r.score,
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
  } catch (e) {
    console.error("[daily-digest] Failed to collect grade transitions:", e);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 11. Yield anomalies
// ---------------------------------------------------------------------------

export async function collectYieldAnomalies(
  ctx: CollectorContext,
): Promise<DigestInputData["yieldAnomalies"]> {
  try {
    const rows = await ctx.db
      .prepare(
        `SELECT stablecoin_id, symbol, current_apy, apy_7d, apy_30d, warning_signals
         FROM yield_data
         WHERE is_best = 1 AND warning_signals IS NOT NULL AND warning_signals != '[]'
         ORDER BY current_apy DESC`,
      )
      .all<{
        stablecoin_id: string; symbol: string;
        current_apy: number; apy_7d: number; apy_30d: number;
        warning_signals: string;
      }>();

    const candidates = (rows.results ?? [])
      .map((r) => {
        let warnings: string[] = [];
        try { warnings = JSON.parse(r.warning_signals) as string[]; } catch { /* expected: malformed warning_signals JSON */ }
        if (warnings.length === 0) return null;

        const mcapUsd = ctx.mcapById.get(r.stablecoin_id) ?? 0;
        if (mcapUsd < 10_000_000) return null;

        return {
          symbol: r.symbol,
          currentApy: Math.round(r.current_apy * 100) / 100,
          apy7d: Math.round(r.apy_7d * 100) / 100,
          apy30d: Math.round(r.apy_30d * 100) / 100,
          warnings,
          mcapUsd,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.mcapUsd * b.warnings.length - a.mcapUsd * a.warnings.length)
      .slice(0, 5);

    return candidates.length > 0 ? candidates : undefined;
  } catch (e) {
    console.error("[daily-digest] Failed to collect yield anomalies:", e);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 12. DEX liquidity shifts (day-over-day)
// ---------------------------------------------------------------------------

export async function collectLiquidityShifts(
  ctx: CollectorContext,
): Promise<DigestInputData["liquidityShifts"]> {
  try {
    // Compare yesterday vs day-before-yesterday.
    // The digest runs at 08:05 UTC — today's dex_liquidity_history row
    // may not exist yet since snapshots come from the :10/:40 cron.
    const dayBeforeYesterday = ctx.yesterdayTs - SECONDS.ONE_DAY;
    const rows = await ctx.db
      .prepare(
        `SELECT h.stablecoin_id, h.liquidity_score, h.total_tvl_usd, h.snapshot_date
         FROM dex_liquidity_history h
         WHERE h.snapshot_date IN (?, ?)
           AND h.liquidity_score IS NOT NULL
         ORDER BY h.stablecoin_id, h.snapshot_date DESC`,
      )
      .bind(ctx.yesterdayTs, dayBeforeYesterday)
      .all<{ stablecoin_id: string; liquidity_score: number; total_tvl_usd: number; snapshot_date: number }>();

    const byId = new Map<string, { latest?: (typeof rows.results)[number]; previous?: (typeof rows.results)[number] }>();
    for (const r of rows.results ?? []) {
      const entry = byId.get(r.stablecoin_id) ?? {};
      if (r.snapshot_date === ctx.yesterdayTs) entry.latest = r;
      else entry.previous = r;
      byId.set(r.stablecoin_id, entry);
    }

    const shifts: NonNullable<DigestInputData["liquidityShifts"]> = [];
    for (const [id, { latest, previous }] of byId) {
      if (!latest || !previous) continue;
      const delta = latest.liquidity_score - previous.liquidity_score;
      if (Math.abs(delta) < 8) continue;

      const mcapUsd = ctx.mcapById.get(id) ?? 0;
      if (mcapUsd < 10_000_000) continue;

      const coin = ctx.trackedStablecoinAssets.find((c) => c.id === id);
      if (!coin) continue;

      shifts.push({
        symbol: coin.symbol,
        currentScore: latest.liquidity_score,
        previousScore: previous.liquidity_score,
        scoreDelta: delta,
        currentTvl: latest.total_tvl_usd,
        previousTvl: previous.total_tvl_usd,
        mcapUsd,
      });
    }

    shifts.sort((a, b) => Math.abs(b.scoreDelta) * b.mcapUsd - Math.abs(a.scoreDelta) * a.mcapUsd);

    return shifts.length > 0 ? shifts.slice(0, 5) : undefined;
  } catch (e) {
    console.error("[daily-digest] Failed to collect liquidity shifts:", e);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 13. Cross-day trends (7-day trajectories from archived digests)
// ---------------------------------------------------------------------------

export async function collectCrossDayTrends(
  ctx: CollectorContext,
): Promise<DigestInputData["crossDayTrends"]> {
  try {
    const rows = await ctx.db
      .prepare(
        `SELECT generated_at, input_data FROM daily_digest
         WHERE generated_at >= ?
           AND (digest_meta IS NULL OR json_extract(digest_meta, '$.type') IS NULL OR json_extract(digest_meta, '$.type') != 'weekly')
         ORDER BY generated_at DESC
         LIMIT 7`,
      )
      .bind(ctx.nowSec - 7 * SECONDS.ONE_DAY)
      .all<{ generated_at: number; input_data: string }>();

    const entries = rows.results ?? [];
    if (entries.length < 3) return undefined;

    const psiTrajectory: { date: string; score: number; band: string }[] = [];
    const mcapTrajectory: { date: string; mcapUsd: number }[] = [];
    const gaugeTrajectory: { date: string; gaugeScore: number }[] = [];

    for (const row of entries) {
      try {
        const data = JSON.parse(row.input_data) as DigestInputData;
        const date = new Date(row.generated_at * 1000).toISOString().slice(0, 10);

        if (data.stabilityIndex) {
          psiTrajectory.push({ date, score: data.stabilityIndex.score, band: data.stabilityIndex.band });
        }
        mcapTrajectory.push({ date, mcapUsd: data.totalMcapUsd });
        if (data.mintBurnFlows) {
          gaugeTrajectory.push({ date, gaugeScore: data.mintBurnFlows.gaugeScore });
        }
      } catch { /* skip malformed entries */ }
    }

    psiTrajectory.reverse();
    mcapTrajectory.reverse();
    gaugeTrajectory.reverse();

    return {
      psiTrajectory,
      mcapTrajectory,
      gaugeTrajectory: gaugeTrajectory.length >= 3 ? gaugeTrajectory : null,
    };
  } catch (e) {
    console.error("[daily-digest] Failed to collect cross-day trends:", e);
    return undefined;
  }
}
